#-------------------------------------------------
#
# Project created by QtCreator 2017-01-24T18:56:12
#
#-------------------------------------------------

QT       += core gui widgets opengl

TARGET = GenesisCA
TEMPLATE = app

# The following define makes your compiler emit warnings if you use
# any feature of Qt which as been marked as deprecated (the exact warnings
# depend on your compiler). Please consult the documentation of the
# deprecated API in order to know how to port your code away from it.
DEFINES += QT_DEPRECATED_WARNINGS

# You can also make your code fail to compile if you use deprecated APIs.
# In order to do so, uncomment the following line.
# You can also select to disable deprecated APIs only up to a certain version of Qt.
#DEFINES += QT_DISABLE_DEPRECATED_BEFORE=0x060000    # disables all the APIs deprecated before Qt 6.0.0

INCLUDEPATH += \
 src/ca_modeler/AttributeHandler/ \
 src/ca_modeler/ModelPropertiesHandler/ \
 src/ca_modeler/VicinityHandler/ \
 src/ca_modeler/UpdateRulesHandler/ \
 src/imgui/ \
 src/imgui/glfw/ \



SOURCES += \
  src/main.cpp \
  src/ca_modeler/ca_modeler_gui.cpp \
  src/ca_model/ca_model.cpp \
    src/ca_model/graph_node.cpp \
    src/ca_model/partition.cpp \
    src/ca_modeler/AttributeHandler/attribute_handler_widget.cpp \
    src/ca_modeler/ModelPropertiesHandler/model_properties_handler_widget.cpp \
    src/ca_modeler/ModelPropertiesHandler/model_attr_init_value.cpp \
    src/ca_modeler/ModelPropertiesHandler/break_case_instance.cpp \
    src/ca_modeler/VicinityHandler/vicinity_handler_widget.cpp \
    src/imgui/imgui.cpp \
    src/imgui/imgui_impl_glfw.cpp \
    src/imgui/main_imgui.cpp \
    src/imgui/imgui_demo.cpp \
    src/imgui/imgui_draw.cpp \
    src/ca_modeler/UpdateRulesHandler/update_rules_handler.cpp

HEADERS  += \
    src/ca_modeler/ca_modeler_gui.h \
    src/ca_model/ca_model.h \
    src/ca_model/graph_node.h \
    src/ca_model/model_properties.h \
    src/ca_model/attribute.h \
    src/ca_model/neighborhood.h \
    src/ca_model/partition.h \
    src/ca_modeler/AttributeHandler/attribute_handler_widget.h \
    src/ca_modeler/ModelPropertiesHandler/model_properties_handler_widget.h \
    src/ca_modeler/ModelPropertiesHandler/model_attr_init_value.h \
    src/ca_model/break_case.h \
    src/ca_modeler/ModelPropertiesHandler/break_case_instance.h \
    src/ca_modeler/VicinityHandler/vicinity_handler_widget.h \
    src/imgui/imgui.h \
    src/imgui/imgui_impl_glfw.h \
    src/imgui/imconfig.h \
    src/imgui/imgui_internal.h \
    src/imgui/glfw/glfw3native.h \
    src/imgui/stb_textedit.h \
    src/imgui/stb_rect_pack.h \
    src/imgui/stb_truetype.h \
    src/ca_modeler/UpdateRulesHandler/update_rules_handler.h

FORMS    += \
    src/ca_modeler/ca_modeler_gui.ui \
    src/ca_modeler/AttributeHandler/attribute_handler_widget.ui \
    src/ca_modeler/ModelPropertiesHandler/model_attr_init_value.ui \
    src/ca_modeler/ModelPropertiesHandler/model_properties_handler_widget.ui \
    src/ca_modeler/ModelPropertiesHandler/break_case_instance.ui \
    src/ca_modeler/VicinityHandler/vicinity_handler_widget.ui \
    src/ca_modeler/UpdateRulesHandler/update_rules_handler.ui

LIBS += -L$$PWD/src/imgui/glfw -lglfw3dll
DEPENDPATH += $$PWD/src/imgui/glfw
